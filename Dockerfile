FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
ENV NODE_ENV=production
# Starts as root only to fix the data folder's owner, then the server switches to the node user.
CMD ["node", "server.js"]
