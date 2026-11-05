FROM golang:1.27.2-bookworm AS build

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .

ARG LOOMHELM_COMPONENT=server
ARG LOOMHELM_BUILD_GOMAXPROCS=2
RUN case "${LOOMHELM_COMPONENT}" in \
      server|worker|connector|deployment-controller) ;; \
      *) echo "unsupported LOOMHELM_COMPONENT: ${LOOMHELM_COMPONENT}" >&2; exit 1 ;; \
    esac \
    && test -d "cmd/${LOOMHELM_COMPONENT}" \
    && GOMAXPROCS="${LOOMHELM_BUILD_GOMAXPROCS}" CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/loomhelm "./cmd/${LOOMHELM_COMPONENT}"

FROM caddy:2.10-alpine AS caddy-runtime

FROM alpine:3.21

RUN apk add --no-cache docker-cli docker-cli-compose \
    && addgroup -S loomhelm \
    && adduser -S -G loomhelm loomhelm \
    && mkdir -p /var/lib/loomhelm/artifacts \
    && chown -R loomhelm:loomhelm /var/lib/loomhelm
COPY --from=build /out/loomhelm /usr/local/bin/loomhelm
COPY --from=caddy-runtime /usr/bin/caddy /usr/local/bin/caddy

USER loomhelm
ENTRYPOINT ["/usr/local/bin/loomhelm"]
