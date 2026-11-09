# WeAgent 任务沙箱（SPEC §11）：非 root、无网络，宿主机 bind mount /workspace
FROM node:24-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl jq git python3 \
	&& rm -rf /var/lib/apt/lists/*

# 非 root 工作用户（uid 1000，与 bind mount 权限对齐）
RUN useradd -m -u 1000 worker && mkdir -p /workspace && chown worker:worker /workspace
USER worker
WORKDIR /workspace

CMD ["sleep", "infinity"]
