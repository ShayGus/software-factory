# Factory UI runtime, separate from Scotty. The base image identity is recorded
# by setup. These tools support the installed FirstMate task wrappers.
ARG BASE=local/scotty:v0.4.0-cf6dda1
FROM ${BASE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends bash jq git \
    && rm -rf /var/lib/apt/lists/*
