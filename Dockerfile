# Stage 1: Build
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src/ src/
COPY tsconfig.json ./
RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY abi.json chain.json ./
COPY migrations/ migrations/
COPY public/ public/
CMD ["node", "dist/index.js"]
