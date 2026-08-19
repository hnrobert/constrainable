# syntax=docker/dockerfile:1
# media-node: pure Go binary (~10MB distroless). SRS runs as a SIDECAR
# container (ossrs/srs:6) sharing two volumes with this one:
#   - srs-conf: this node renders srs.conf.template (env-substituted) onto it
#     at startup; the SRS container waits for the file, then starts with it.
#     This node stays the single owner of SRS configuration.
#   - records: SRS DVR writes FLV segments; this node scans them to report
#     recordings to the control plane.
# (SRS_BIN may still point at an in-container binary to run SRS as a child
# process instead — used by non-Docker setups.)
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/media-node .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/media-node /usr/local/bin/media-node
COPY --from=build /src/srs.conf.template /etc/media-node/srs.conf.template
# Mount point for the rendered config shared with the SRS sidecar. Pre-created
# owned by the nonroot user (uid 65532) — distroless has no shell, so the dir
# can't be chowned at runtime, and named volumes initialize from image dir
# ownership; without this the nonroot process couldn't write the config.
COPY --from=build --chown=65532:65532 /src/srs.conf.template /srs-config/.placeholder

EXPOSE 1935 38080

ENV RECORD_DIR=/records \
    SRS_CONFIG_PATH=/srs-config/srs.conf

ENTRYPOINT ["/usr/local/bin/media-node"]
