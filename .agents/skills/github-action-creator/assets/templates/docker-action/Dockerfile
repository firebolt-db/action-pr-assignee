# Keep the base image small — it's pulled on every workflow run when building
# from Dockerfile. For production, build once in a release workflow and push
# to GHCR, then reference with:
#   image: 'docker://ghcr.io/<org>/<action>:<tag>'
FROM alpine:3.19

# If your action needs extra tooling, install it here. Pin versions so the
# image is reproducible.
# RUN apk add --no-cache curl jq

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
