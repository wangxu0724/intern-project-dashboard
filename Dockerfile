FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY . .

ENV PORT=4173
EXPOSE 4173
CMD ["npm", "start"]
