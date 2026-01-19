# Use a lightweight Node image
FROM node:18-slim

# 1. Install Ghostscript (The Critical Step)
# We update apt-get and install ghostscript
RUN apt-get update && apt-get install -y \
    ghostscript \
    && rm -rf /var/lib/apt/lists/*

# 2. Set the working directory
WORKDIR /app

# 3. Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# 4. Copy the rest of the application code
COPY . .

# 5. Create the uploads directory required by your code
RUN mkdir -p uploads

# 6. Expose the port (Render typically uses 10000 or expects you to read PORT env)
EXPOSE 3000

# 7. Start the server
CMD ["node", "server.js"]
