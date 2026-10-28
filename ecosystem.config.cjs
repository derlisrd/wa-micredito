module.exports = {
  apps: [
    {
      name: "wa",
      script: "index.js",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1, // WhatsApp Web solo admite una sesión por usuario
      autorestart: true,
      watch: false,
      max_restarts: 20,
      min_uptime: "30s",
      restart_delay: 5000,
      exp_backoff_restart_delay: 2000,
      max_memory_restart: "600M",
      kill_timeout: 25000,
      time: true,
      merge_logs: true,
      out_file: "./logs/out.log",
      error_file: "./logs/error.log",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
