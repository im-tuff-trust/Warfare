# Realtime WebSocket relay for WARFARE (deploy separately from the Vercel frontend)
FROM node:22-alpine
WORKDIR /app
RUN npm init -y >/dev/null && npm install ws@8 --omit=dev
COPY realtime.mjs ./
ENV PORT=8787
EXPOSE 8787
CMD ["node", "realtime.mjs"]
