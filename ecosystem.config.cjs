module.exports = {
  apps: [
    {
      name: "unitv-agent",
      script: "npm",
      args: "run start -- --hostname 127.0.0.1 --port 3000",
      cwd: "/var/www/unitv",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: "3000"
      }
    }
  ]
};
