FROM mcr.microsoft.com/playwright:v1.58.0-noble

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=4173
EXPOSE 4173

CMD ["npm", "start"]
