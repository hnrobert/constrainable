package rtmp

// End-to-end auth test: a fake librtmp client performs the 3-connection Adobe
// authmod dance against the gateway, which calls a mock app exposing the same
// salt/verify contract as the real /api/srs/rtmp-auth/* endpoints. This proves
// the full auth path (handshake → stage 1/2/3 → verify) without OBS.

import (
	"bytes"
	"crypto/md5"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime/debug"
	"strings"
	"testing"
	"time"
)

func md5raw(s string) []byte { h := md5.Sum([]byte(s)); return h[:] }
func b64(b []byte) string    { return base64.StdEncoding.EncodeToString(b) }

func randB64(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.StdEncoding.EncodeToString(b)
}

// startGateway runs the OBS-facing handler on an ephemeral port; no SRS needed
// for auth-only exercises (the relay is only reached after a successful publish).
func startGateway(t *testing.T, appBase, token string) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	app := NewTestAppClient(appBase, token)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("gateway handler panic: %v\n%s", r, debug.Stack())
					}
					_ = c.Close()
				}()
				HandleOBS(c, app)
			}()
		}
	}()
	return ln.Addr().String()
}

// openClient dials the gateway, handshakes, and advertises a chunk size (like
// OBS does) so the gateway reads our single-chunk connect correctly.
func openClient(t *testing.T, addr string) (net.Conn, *chunkWriter, *chunkReader) {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	if err := ClientHandshake(c); err != nil {
		t.Fatal(err)
	}
	cw := NewChunkWriter(c)
	cr := NewChunkReader(c)
	_ = cw.WriteMessage(&Message{Type: 1, CSID: 2, Payload: PutBE4(4096)})
	return c, cw, cr
}

func sendConnect(cw *chunkWriter, app string) {
	_ = cw.WriteMessage(&Message{Type: 20, CSID: 3, Payload: CmdConnect(app, "rtmp://test/live")})
}

// cmdField reads the gateway's next command and returns a combined string of the
// info object's description + code, so assertions can match either.
func cmdField(cr *chunkReader) string {
	for {
		m, err := cr.ReadMessage()
		if err != nil {
			return "ERR:" + err.Error()
		}
		if m.Type == 1 {
			cr.chunkSize = int(BE32(m.Payload))
			continue
		}
		if m.Type != 20 && m.Type != 17 {
			continue
		}
		var parts []string
		for _, v := range AmfDecodeAll(m.Payload) {
			if o, ok := v.(map[string]interface{}); ok {
				if d, _ := o["description"].(string); d != "" {
					parts = append(parts, d)
				}
				if c, _ := o["code"].(string); c != "" {
					parts = append(parts, c)
				}
			}
		}
		return strings.Join(parts, " | ")
	}
}

// danceAuth mimics librtmp's full 3-connection authmod dance and returns the
// still-open stage-3 connection (already at Connect.Success). Non-fatal helper
// for callers that continue to createStream/publish on the same connection.
func danceAuth(t *testing.T, addr, user, password string) (net.Conn, *chunkWriter, *chunkReader) {
	t.Helper()

	// stage 1 — fresh connect → expect authmod demand
	c, cw, cr := openClient(t, addr)
	sendConnect(cw, "live")
	d1 := cmdField(cr)
	c.Close()
	if !strings.Contains(d1, "authmod=adobe") {
		t.Fatalf("stage1: expected authmod demand, got %q", d1)
	}

	// stage 2 — offer user → expect salt + opaque challenge
	c, cw, cr = openClient(t, addr)
	sendConnect(cw, "live?authmod=adobe&user="+user)
	d2 := cmdField(cr)
	c.Close()
	if !strings.Contains(d2, "reason=needauth") {
		t.Fatalf("stage2: expected needauth challenge, got %q", d2)
	}
	salt := kv(d2, "salt")
	opaque := kv(d2, "opaque")
	if salt == "" || opaque == "" {
		t.Fatalf("stage2: no salt/opaque in %q", d2)
	}

	// stage 3 — compute the librtmp response and reconnect
	challenge := randB64(8)
	salted2 := b64(md5raw(user + salt + password))
	response := b64(md5raw(salted2 + opaque + challenge))
	c, cw, cr = openClient(t, addr)
	sendConnect(cw, "live?authmod=adobe&user="+user+"&challenge="+challenge+"&response="+response+"&opaque="+opaque)
	if got := cmdField(cr); !strings.Contains(got, "NetConnection.Connect.Success") {
		c.Close()
		t.Fatalf("stage3: expected Connect.Success, got %q", got)
	}
	return c, cw, cr
}

// credlessConnect mimics a client with NO credentials configured: conn1 gets the
// authmod demand, conn2 answers with an EMPTY user and must be accepted openly
// (the single-URL escape hatch for requireAccountAuth-off events).
func credlessConnect(t *testing.T, addr string) (net.Conn, *chunkWriter, *chunkReader) {
	t.Helper()

	c, cw, cr := openClient(t, addr)
	sendConnect(cw, "live")
	d1 := cmdField(cr)
	c.Close()
	if !strings.Contains(d1, "authmod=adobe") {
		t.Fatalf("credless stage1: expected authmod demand, got %q", d1)
	}

	c2, cw2, cr2 := openClient(t, addr)
	sendConnect(cw2, "live?authmod=adobe&user=")
	if got := cmdField(cr2); !strings.Contains(got, "NetConnection.Connect.Success") {
		c2.Close()
		t.Fatalf("credless stage2: expected open Connect.Success, got %q", got)
	}
	return c2, cw2, cr2
}

// kv pulls key=value out of a query-like description without url-decoding.
func kv(q, key string) string {
	idx := strings.Index(q, key+"=")
	if idx < 0 {
		return ""
	}
	rest := q[idx+len(key)+1:]
	if i := strings.IndexByte(rest, '&'); i >= 0 {
		rest = rest[:i]
	}
	return rest
}

func TestAuthmodSuccessAndFailure(t *testing.T) {
	const (
		user     = "robert@example.com"
		password = "123456"
		salt     = "deadbeefsalt"
		token    = "test-token"
	)
	salted2 := b64(md5raw(user + salt + password)) // the stored verifier

	app := httptest.NewServer(mockAppMux(token, "", "", user, salt, salted2))
	defer app.Close()
	addr := startGateway(t, app.URL, token)

	// right password: the full dance reaches Connect.Success (authed)
	c, _, cr := danceAuth(t, addr, user, password)
	defer c.Close()
	_ = cr
	// WRONG password on a KNOWN account is now FATAL: librtmp's authfailed
	// error, connection refused outright (no connect-then-loop)
	if got := danceWrongPassword(t, addr, user, "wrongpw", salt); !strings.Contains(got, "reason=authfailed") {
		t.Fatalf("wrong password: expected fatal authfailed error, got %q", got)
	}
}

// danceUnknownUser runs the dance with an unregistered username — the gateway
// must accept it (placeholder credentials for no-auth events), unauthenticated.
func danceUnknownUser(t *testing.T, addr, user string) (net.Conn, *chunkWriter, *chunkReader) {
	t.Helper()
	c, cw, cr := openClient(t, addr)
	sendConnect(cw, "live")
	cmdField(cr) // stage1 demand
	c.Close()

	c, cw, cr = openClient(t, addr)
	sendConnect(cw, "live?authmod=adobe&user="+user)
	d2 := cmdField(cr) // random salt challenge for unknown user
	c.Close()
	salt := kv(d2, "salt")
	opaque := kv(d2, "opaque")
	challenge := randB64(8)
	salted2 := b64(md5raw(user + salt + "whatever"))
	response := b64(md5raw(salted2 + opaque + challenge))
	c, cw, cr = openClient(t, addr)
	sendConnect(cw, "live?authmod=adobe&user="+user+"&challenge="+challenge+"&response="+response+"&opaque="+opaque)
	if got := cmdField(cr); !strings.Contains(got, "NetConnection.Connect.Success") {
		c.Close()
		t.Fatalf("unknown user: expected accepted Connect.Success, got %q", got)
	}
	return c, cw, cr
}

// danceWrongPassword runs the dance with a WRONG password and returns the
// stage-3 command field (graceful: expect Connect.Success, unauthenticated).
func danceWrongPassword(t *testing.T, addr, user, wrongPassword, salt string) string {
	t.Helper()
	c, cw, cr := openClient(t, addr)
	sendConnect(cw, "live")
	cmdField(cr) // stage1 demand
	c.Close()

	c, cw, cr = openClient(t, addr)
	sendConnect(cw, "live?authmod=adobe&user="+user)
	d2 := cmdField(cr) // salt+opaque
	c.Close()
	opaque := kv(d2, "opaque")
	challenge := randB64(8)
	salted2 := b64(md5raw(user + salt + wrongPassword))
	response := b64(md5raw(salted2 + opaque + challenge))
	c, cw, cr = openClient(t, addr)
	defer c.Close()
	sendConnect(cw, "live?authmod=adobe&user="+user+"&challenge="+challenge+"&response="+response+"&opaque="+opaque)
	return cmdField(cr)
}

// mockAppMux exposes the gateway's app contract: salt + verify (one known user)
// and policy. authKey requires account auth; openKey doesn't; closedKey's event
// window is shut; anything else is an unknown token.
func mockAppMux(token, authKey, openKey, user, salt, salted2 string) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/srs/rtmp-auth/salt", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-rtmp-auth") != token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		email := r.URL.Query().Get("email")
		if email == "banned@x.com" {
			_, _ = io.WriteString(w, `{"salt":"`+salt+`","banned":true}`)
			return
		}
		if email == user {
			_, _ = io.WriteString(w, `{"salt":"`+salt+`"}`)
		} else {
			w.WriteHeader(http.StatusNotFound)
		}
	})
	mux.HandleFunc("/api/srs/rtmp-auth/verify", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-rtmp-auth") != token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		b, _ := io.ReadAll(r.Body)
		opaque := between(string(b), `"opaque":"`, `"`)
		challenge := between(string(b), `"challenge":"`, `"`)
		response := between(string(b), `"response":"`, `"`)
		email := between(string(b), `"email":"`, `"`)
		expect := b64(md5raw(salted2 + opaque + challenge))
		known := email == user && user != ""
		_, _ = io.WriteString(w, `{"allow":`+b2s(known && response == expect)+`,"known":`+b2s(known)+`}`)
	})
	mux.HandleFunc("/api/srs/rtmp-auth/policy", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-rtmp-auth") != token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		tok := r.URL.Query().Get("token")
		stream := r.URL.Query().Get("stream")
		const closedKey = "closedkey1" // publish key whose event window is shut
		isKey := (tok == authKey && authKey != "") || (tok == openKey && openKey != "") || tok == closedKey
		require := isKey && tok == authKey
		open := tok != closedKey
		banned := stream == "banned@example.com"
		_, _ = io.WriteString(w, `{"publishKey":`+b2s(isKey)+`,"requireAccountAuth":`+b2s(require)+`,"windowOpen":`+b2s(open)+`,"banned":`+b2s(banned)+`}`)
	})
	return mux
}

// A client with NO credentials passes the challenge via the empty-user escape
// hatch (stage1 demand → stage2 empty user → open Connect.Success) and can then
// createStream normally.
func TestCredlessClientPassesThrough(t *testing.T) {
	const token = "test-token"
	app := httptest.NewServer(mockAppMux(token, "", "", "u@example.com", "s", "v"))
	defer app.Close()
	addr := startGateway(t, app.URL, token)

	c, cw, cr := credlessConnect(t, addr)
	defer c.Close()
	_ = cw.WriteMessage(&Message{Type: 20, CSID: 3, Payload: CmdCreateStream()})
	if got := nextCmdName(cr); got != "_result" {
		t.Fatalf("credless createStream: expected _result, got %q", got)
	}
}

// nextCmdName reads until the next AMF command and returns its method name.
func nextCmdName(cr *chunkReader) string {
	for {
		m, err := cr.ReadMessage()
		if err != nil {
			return "ERR:" + err.Error()
		}
		if m.Type != 20 && m.Type != 17 {
			continue
		}
		vals := AmfDecodeAll(m.Payload)
		if len(vals) > 0 {
			if s, ok := vals[0].(string); ok {
				return s
			}
		}
	}
}

// fakeSRS is a minimal SRS publisher endpoint: handshakes server-side, answers
// connect/createStream, records the publish stream name, and acknowledges with
// Publish.Start so the gateway's upstream path completes.
func fakeSRS(t *testing.T, names chan<- string) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = recover(); _ = c.Close() }()
				if err := ServerHandshake(c); err != nil {
					return
				}
				cw := NewChunkWriter(c)
				cr := NewChunkReader(c)
				// Announce our chunk size like real SRS does — without this the
				// gateway's reader stays at its 128-byte default and misframes
				// our larger command replies.
				_ = cw.WriteMessage(&Message{Type: 1, CSID: 2, Payload: PutBE4(4096)})
				for {
					m, err := cr.ReadMessage()
					if err != nil {
						return
					}
					if m.Type == 1 {
						cr.chunkSize = int(BE32(m.Payload))
						continue
					}
					if m.Type != 20 && m.Type != 17 {
						continue
					}
					vals := AmfDecodeAll(m.Payload)
					if len(vals) == 0 {
						continue
					}
					cmd, _ := vals[0].(string)
					txn := 0.0
					if len(vals) >= 2 {
						txn, _ = vals[1].(float64)
					}
					switch cmd {
					case "connect":
						_ = cw.WriteMessage(&Message{Type: 20, CSID: 3, Payload: CmdConnectOK(txn)})
					case "createStream":
						_ = cw.WriteMessage(&Message{Type: 20, CSID: 3, Payload: CmdCreateStreamResult(txn, 1)})
					case "publish":
						if len(vals) >= 4 {
							n, _ := vals[3].(string)
							select {
							case names <- n:
							default:
							}
						}
						_ = cw.WriteMessage(&Message{Type: 20, CSID: 5, StreamID: 1, Payload: CmdOnStatusPublishStart()})
						// stay connected like real SRS — exiting here closes the
						// upstream, and the gateway's upstream-gone watcher then
						// kills the OBS side (races post-publish frames)
						continue
					}
				}
			}()
		}
	}()
	return ln.Addr().String()
}

// expectName waits for the next upstream publish name and asserts it.
func expectName(t *testing.T, ch <-chan string, want string) {
	t.Helper()
	select {
	case got := <-ch:
		if got != want {
			t.Fatalf("upstream publish name: want %q, got %q", want, got)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("upstream publish never arrived (wanted %q)", want)
	}
}

// Publish-time behavior: per-event enforcement + stream-name derivation now that
// the OBS stream key is the publish key ALONE (no email prefix).
func TestPublishPolicyEnforcement(t *testing.T) {
	const (
		token     = "test-token"
		authKey   = "authkey123"
		openKey   = "openkey123"
		closedKey = "closedkey1"
		password  = "123456"
		salt      = "deadbeefsalt"
		user      = "robert@example.com"
	)
	salted2 := b64(md5raw(user + salt + password))
	app := httptest.NewServer(mockAppMux(token, authKey, openKey, user, salt, salted2))
	defer app.Close()
	addr := startGateway(t, app.URL, token)

	names := make(chan string, 8)
	oldSRS := SRSAddr
	SRSAddr = fakeSRS(t, names)
	defer func() { SRSAddr = oldSRS }()

	// 1) credless connection + bare auth-requiring key → rejected
	c, cw, cr := credlessConnect(t, addr)
	_ = cw.WriteMessage(&Message{Type: 20, CSID: 3, StreamID: 1, Payload: CmdPublish(authKey)})
	if got := cmdField(cr); !strings.Contains(got, "NetStream.Publish.BadName") {
		c.Close()
		t.Fatalf("auth key, credless conn: expected BadName rejection, got %q", got)
	}
	c.Close()

	// 1c) window-closed key (even AUTHED) → BadName "window closed" — OBS stops
	// instead of retry-looping
	c, cw, cr = danceAuth(t, addr, user, password)
	_ = cw.WriteMessage(&Message{Type: 20, CSID: 3, StreamID: 1, Payload: CmdPublish("closedkey1")})
	if got := cmdField(cr); !strings.Contains(got, "streaming window is closed") {
		c.Close()
		t.Fatalf("closed-window key: expected window-closed BadName, got %q", got)
	}
	c.Close()
	_ = cr

	// 2) authed publisher + bare auth key → upstream name = the authed email
	c, cw, cr = danceAuth(t, addr, user, password)
	_ = cw.WriteMessage(&Message{Type: 20, CSID: 3, StreamID: 1, Payload: CmdPublish(authKey)})
	expectName(t, names, "robert@example.com?token="+authKey)
	c.Close()

	// 3) authed publisher under ANOTHER user's explicit name → rejected
	c, cw, cr = danceAuth(t, addr, user, password)
	_ = cw.WriteMessage(&Message{Type: 20, CSID: 3, StreamID: 1, Payload: CmdPublish("victim@example.com?token=" + authKey)})
	if got := cmdField(cr); !strings.Contains(got, "NetStream.Publish.BadName") {
		c.Close()
		t.Fatalf("impersonation: expected BadName rejection, got %q", got)
	}
	c.Close()

	// 4) credless connection + bare no-auth key → upstream name from client IP
	c, cw, cr = credlessConnect(t, addr)
	_ = cw.WriteMessage(&Message{Type: 20, CSID: 3, StreamID: 1, Payload: CmdPublish(openKey)})
	expectName(t, names, "ip-127.0.0.1?token="+openKey)
	c.Close()

	// 5) credless connection + explicit name on a no-auth key → honored verbatim
	c, cw, cr = credlessConnect(t, addr)
	_ = cw.WriteMessage(&Message{Type: 20, CSID: 3, StreamID: 1, Payload: CmdPublish("alice?token=" + openKey)})
	expectName(t, names, "alice?token="+openKey)
	c.Close()

	// 6) unknown token (wrong event key) → immediate BadName, nothing relayed
	c, cw, cr = credlessConnect(t, addr)
	_ = cw.WriteMessage(&Message{Type: 20, CSID: 3, StreamID: 1, Payload: CmdPublish("studentkey0001")})
	if got := cmdField(cr); !strings.Contains(got, "unknown event key") {
		c.Close()
		t.Fatalf("unknown token: expected unknown-event-key BadName, got %q", got)
	}
	c.Close()

	// 7) banned stream name (recently kicked) → BadName, nothing relayed
	c, cw, cr = danceAuth(t, addr, user, password)
	_ = cw.WriteMessage(&Message{Type: 20, CSID: 3, StreamID: 1, Payload: CmdPublish("banned@example.com?token=" + openKey)})
	if got := cmdField(cr); !strings.Contains(got, "disconnected by the organizer") {
		c.Close()
		t.Fatalf("banned stream: expected kick BadName, got %q", got)
	}
	c.Close()

	// 8) unknown-user (placeholder creds) + no-auth key → accepted, ip-name stream
	c, cw, cr = danceUnknownUser(t, addr, "placeholder@nowhere.dev")
	_ = cw.WriteMessage(&Message{Type: 20, CSID: 3, StreamID: 1, Payload: CmdPublish(openKey)})
	expectName(t, names, "ip-127.0.0.1?token="+openKey)
	c.Close()
	_ = cr
}

func between(s, a, b string) string {
	i := strings.Index(s, a)
	if i < 0 {
		return ""
	}
	s = s[i+len(a):]
	if j := strings.Index(s, b); j >= 0 {
		return s[:j]
	}
	return s
}

func b2s(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// A banned user must be refused at STAGE 2 of the dance (fatal authfailed),
// so OBS stops its reconnect loop at connect time instead of reaching publish.
func TestStage2BanRefusesConnection(t *testing.T) {
	const (
		user  = "robert@example.com"
		salt  = "deadbeefsalt"
		token = "test-token"
	)
	salted2 := b64(md5raw(user + salt + "123456"))
	app := httptest.NewServer(mockAppMux(token, "", "", user, salt, salted2))
	defer app.Close()
	addr := startGateway(t, app.URL, token)

	c, cw, cr := openClient(t, addr)
	defer c.Close()
	sendConnect(cw, "live")
	cmdField(cr) // stage1 demand
	c.Close()

	c, cw, cr = openClient(t, addr)
	defer c.Close()
	sendConnect(cw, "live?authmod=adobe&user=banned@x.com")
	if got := cmdField(cr); !strings.Contains(got, "reason=authfailed") {
		t.Fatalf("banned user stage2: expected fatal authfailed, got %q", got)
	}
}

// NewTestAppClient creates a real HTTP AppClient pointed at the test mock server.
func NewTestAppClient(baseURL, token string) AppClient {
	return NewHTTPAuthClient(baseURL, token)
}

// NewHTTPAuthClient is a minimal HTTP auth client for the rtmp package's tests.
// In production, api.AuthClient (in the api package) serves this role.
func NewHTTPAuthClient(base, token string) *httpAuthClient {
	return &httpAuthClient{base: base, token: token}
}

type httpAuthClient struct {
	base  string
	token string
}

func (h *httpAuthClient) Salt(email string) SaltResult {
	req, _ := http.NewRequest("GET", h.base+"/api/srs/rtmp-auth/salt?email="+email, nil)
	req.Header.Set("x-rtmp-auth", h.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 {
		return SaltResult{Salt: RandHex(8)}
	}
	defer resp.Body.Close()
	var body struct {
		Salt   string `json:"salt"`
		Banned bool   `json:"banned"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&body)
	return SaltResult{Salt: body.Salt, Banned: body.Banned}
}

func (h *httpAuthClient) Verify(email, opaque, challenge, response string) VerifyResult {
	body, _ := json.Marshal(map[string]string{
		"email": email, "opaque": opaque, "challenge": challenge, "response": response,
	})
	req, _ := http.NewRequest("POST", h.base+"/api/srs/rtmp-auth/verify", bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-rtmp-auth", h.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 {
		return VerifyResult{}
	}
	defer resp.Body.Close()
	var out struct {
		Allow bool `json:"allow"`
		Known bool `json:"known"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return VerifyResult{Allow: out.Allow, Known: out.Known}
}

func (h *httpAuthClient) Policy(token, stream string) PolicyResult {
	req, _ := http.NewRequest("GET", h.base+"/api/srs/rtmp-auth/policy?token="+token+"&stream="+stream, nil)
	req.Header.Set("x-rtmp-auth", h.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 {
		return PolicyResult{}
	}
	defer resp.Body.Close()
	var out struct {
		PublishKey         bool `json:"publishKey"`
		RequireAccountAuth bool `json:"requireAccountAuth"`
		WindowOpen         bool `json:"windowOpen"`
		Banned             bool `json:"banned"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return PolicyResult{
		PublishKey: out.PublishKey, RequireAccountAuth: out.RequireAccountAuth,
		WindowOpen: out.WindowOpen, Banned: out.Banned,
	}
}
