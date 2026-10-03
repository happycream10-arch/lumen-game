FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node dist ./dist
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node standalone ./standalone
COPY --chown=node:node package.json ./package.json
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/app/data/lumen.sqlite
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","standalone/server.mjs"]
