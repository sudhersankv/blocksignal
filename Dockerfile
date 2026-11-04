FROM node:22-slim
WORKDIR /app
# Python runtime for the P3 Shop Opener engine (server/py/blockgap.py)
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*
COPY server/py/requirements.txt* /app/server/py/
RUN if [ -f /app/server/py/requirements.txt ]; then pip3 install --no-cache-dir --break-system-packages -r /app/server/py/requirements.txt; fi
COPY . .
RUN mkdir -p data
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server/server.js"]
