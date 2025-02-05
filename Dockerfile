# Use Node.js 18 slim image with additional build tools
FROM node:18-slim

# Install Python and build dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    gcc \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Create client directory
RUN mkdir -p /app/client

# Copy the rest of the application
COPY . .

# Expose port
EXPOSE 5000

# Command to run the application
CMD ["npm", "start"]
