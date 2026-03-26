FROM node:24-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Copy source and supporting files
COPY src/ ./src/
COPY prompts/ ./prompts/
COPY routing.json ./
COPY tsconfig.json ./

# Install tsx and Claude Code CLI
RUN npm install -g tsx @anthropic-ai/claude-code

EXPOSE 8080
ENV PORT=8080

CMD ["tsx", "src/index.ts"]
