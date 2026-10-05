FROM node:22-alpine AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@ffp/dashboard...

FROM nginx:1.27-alpine AS runtime
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/dashboard/docker-entrypoint.sh /docker-entrypoint.d/40-ffp-config.sh
COPY --from=build /repo/apps/dashboard/dist /usr/share/nginx/html
RUN chmod +x /docker-entrypoint.d/40-ffp-config.sh
EXPOSE 80
