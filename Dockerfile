# Use Python 3.8 slim image
FROM python:3.8-slim

# Install git and curl
RUN apt-get update && apt-get install -y git curl && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy the local files
COPY . .

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Expose both internal and external ports
EXPOSE 5000 15000

# Command to run the application
CMD ["python", "server/server.py"]
