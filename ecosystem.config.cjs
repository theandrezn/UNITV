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
    },
    {
      name: "unitv-followups-worker",
      script: "scripts/followups-worker.mjs",
      cwd: "/var/www/unitv",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
        FOLLOWUPS_JOB_URL: "http://127.0.0.1:3000/api/jobs/followups",
        FOLLOWUPS_WORKER_INTERVAL_MS: "60000"
      }
    }
  ]
};
