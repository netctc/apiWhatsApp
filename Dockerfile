FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build?schema=public npm run prisma:generate && npm run build

FROM node:24-alpine AS runtime

ARG APP_VERSION=unknown
ARG APP_REVISION=
ARG APP_SOURCE_URL=

WORKDIR /app
LABEL org.opencontainers.image.title="api-whatsapp" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${APP_REVISION}" \
      org.opencontainers.image.source="${APP_SOURCE_URL}"
ENV NODE_ENV=production \
    APP_REVISION="${APP_REVISION}"

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=peer --omit=optional --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000

CMD ["node", "dist/main.js"]
