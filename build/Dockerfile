FROM golang:1.27.2-bookworm AS build

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .

ARG LOOMHELM_COMPONENT=server
RUN case "${LOOMHELM_COMPONENT}" in \
      server|worker|connector) ;; \
      *) echo "unsupported LOOMHELM_COMPONENT: ${LOOMHELM_COMPONENT}" >&2; exit 1 ;; \
    esac \
    && test -d "cmd/${LOOMHELM_COMPONENT}" \
    && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/loomhelm "./cmd/${LOOMHELM_COMPONENT}"

FROM alpine:3.21

RUN addgroup -S loomhelm && adduser -S -G loomhelm loomhelm
COPY --from=build /out/loomhelm /usr/local/bin/loomhelm

USER loomhelm
ENTRYPOINT ["/usr/local/bin/loomhelm"]
