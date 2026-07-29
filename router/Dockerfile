# Built for the Railway `router` service (root = router/, direct `railway up`).
# A Dockerfile because the platform builders proved non-deterministic here:
# Railpack ran `npm install` and never `npm run build`, so dist/ was missing.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
# Railway routes and healthchecks the exposed port; keep in sync with PORT
EXPOSE 8080
CMD ["node", "dist/index.js"]
