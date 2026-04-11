module.exports = {
  apps: [
    {
      name: 'sinepilstream',
      script: 'server.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3500,
      },
      // Auto-restart on crash
      autorestart: true,
      // Restart if memory exceeds 300MB (scraping can be memory-heavy)
      max_memory_restart: '300M',
      // Log files
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
