# The schema's migrations as an image (P2-01), run by an Azure Container Apps job before each deploy,
# with the same dbmate the local stack uses (compose.yaml). Build from the repository root:
#   docker build -f db/Dockerfile .
FROM ghcr.io/amacneil/dbmate:2.37.0@sha256:0101fcc9999596f4a6930e5627296cd91f3bfa225e3e8c1699fc00881e439cc6
COPY db/migrations /db/migrations
ENV DBMATE_MIGRATIONS_DIR=/db/migrations
# The migrations are the schema's record, as locally.
ENV DBMATE_NO_DUMP_SCHEMA=true
# DATABASE_URL comes from the environment. Wait for the database, then apply anything new.
CMD ["--wait", "up"]
