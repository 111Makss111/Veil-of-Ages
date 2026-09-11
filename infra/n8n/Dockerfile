FROM docker.n8n.io/n8nio/n8n:2.38.7
COPY --chown=node:node start.mjs /opt/veil-start.mjs
ENV N8N_PORT=5678
EXPOSE 5678
ENTRYPOINT ["tini", "--", "node", "/opt/veil-start.mjs"]
