# Legacy runtime extension. The monorepo builds services/scotty.Dockerfile instead.
ARG BASE
FROM ${BASE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends bash jq git \
    && rm -rf /var/lib/apt/lists/*
