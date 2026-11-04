FROM node:22-slim
WORKDIR /app
COPY . .
RUN mkdir -p data
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server/server.js"]
