FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Copy source and supporting files
COPY src/ ./src/
COPY prompts/ ./prompts/
COPY routing.json ./
COPY tsconfig.json ./

# Install tsx for running TypeScript directly (avoids build step complexity)
RUN npm install -g tsx

EXPOSE 8080
ENV PORT=8080

CMD ["tsx", "src/index.ts"]
