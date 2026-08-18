# syntax=docker/dockerfile:1
# media-node: pure Go binary + embedded SRS config on distroless (~10MB).
#
# The SRS config template is bundled INSIDE this image. At startup, the Go
# binary renders it with env-var substitution ($SRS_RTC_CANDIDATE) and writes
# it to /tmp/srs.conf, then starts SRS as a child process. This makes each
# media-node container fully self-contained — no volume mounts or external
# config files needed.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/media-node .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/media-node /usr/local/bin/media-node
COPY --from=build /src/srs.conf.template /etc/media-node/srs.conf.template

EXPOSE 1935 8080 1985 8000/udp

ENV RECORD_DIR=/records \
    SRS_BIN=/usr/local/srs/objs/srs

ENTRYPOINT ["/usr/local/bin/media-node"]
