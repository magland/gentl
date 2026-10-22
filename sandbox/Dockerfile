# Default gentl sandbox: Debian (trixie) with Python, Node, build tools, git, curl and w3m.
# The image tag is derived from this file's content, so editing it yields a new image.
FROM python:3.13-slim-trixie
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates w3m build-essential nodejs npm procps \
    && rm -rf /var/lib/apt/lists/*
ENV PIP_ROOT_USER_ACTION=ignore PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TERM=dumb NO_COLOR=1 PAGER=cat GIT_PAGER=cat GIT_TERMINAL_PROMPT=0
WORKDIR /work
