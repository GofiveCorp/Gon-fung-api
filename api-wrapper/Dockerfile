# api-wrapper/Dockerfile
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# เพิ่ม bash (และ docker-cli ถ้าสคริปต์ใช้ docker)
RUN apk add --no-cache bash docker-cli

COPY package*.json ./
RUN npm ci --omit=dev
RUN npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner

COPY . .
EXPOSE 3300
CMD ["npm","start"]
ENV RUN_MODE=script
ENV RUN_SCRIPT=/meet-teams-bot/run_bot.sh
ENV BOT_API_BASE=http://bot:8080

CMD ["node", "app.js"]
