FROM node:24

WORKDIR /app
COPY src/ ./src/

ENV HOST=0.0.0.0

CMD ["node", "src/server.cjs"]
