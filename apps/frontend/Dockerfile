# syntax=docker/dockerfile:1
FROM node:20-alpine

# Work inside the container
WORKDIR /usr/src/app

# Copy ONLY the React app's manifest first (for better caching)
COPY react/package*.json ./

# Install deps using the lockfile from react/
RUN npm ci

# Now bring in the rest of the React app
COPY react/. .

# If you're running the Vite dev server in the container:
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
