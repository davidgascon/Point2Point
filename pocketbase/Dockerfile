FROM alpine:3.20

ARG PB_VERSION=0.29.3
ARG TARGETARCH=amd64

RUN apk add --no-cache ca-certificates unzip wget

WORKDIR /pb
RUN wget -q -O /tmp/pb.zip \
      "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${TARGETARCH}.zip" \
 && unzip -o /tmp/pb.zip -d /pb \
 && rm /tmp/pb.zip \
 && chmod +x /pb/pocketbase

# Schema migrations travel in the image, so there is no bind mount to go wrong.
COPY pb_migrations/ /pb/pb_migrations/

EXPOSE 8090

CMD ["/pb/pocketbase", "serve", \
     "--http=0.0.0.0:8090", \
     "--dir=/pb/pb_data", \
     "--migrationsDir=/pb/pb_migrations"]
