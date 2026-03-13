module.exports = {
    apps: [
        {
            name: "pdf-api-server",
            script: "./src/server.js",
            instances: 1,
            exec_mode: "fork",
            error_file: "./logs/api-error.log",
            out_file: "./logs/api-out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss",
            env: { NODE_ENV: "production" }
        },
        {
            name: "pdf-worker",
            script: "./src/jobs/worker.js",
            instances: 3,
            exec_mode: "cluster",
            error_file: "./logs/worker-error.log",
            out_file: "./logs/worker-out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss",
            merge_logs: true,
            max_memory_restart: "1500M",
            env: { NODE_ENV: "production" }
        },
        {
            name: "gmail-scanner",
            script: "./src/jobs/gmail_poll.js",
            instances: 1,
            exec_mode: "fork",
            error_file: "./logs/gmail-error.log",
            out_file: "./logs/gmail-out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss",
            autorestart: true,
            env: { NODE_ENV: "production" }
        },
        {
            name: "metadata-watcher",
            script: "./src/watchers/metadata.watcher.js",
            instances: 1,
            exec_mode: "fork",
            error_file: "./logs/watcher-soap-error.log",
            out_file: "./logs/watcher-soap-out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss",
            env: { NODE_ENV: "production" }
        },
        {
            name: "soap-worker",
            script: "./src/jobs/soap.worker.js",
            instances: 1,
            exec_mode: "fork",
            error_file: "./logs/soap-worker-error.log",
            out_file: "./logs/soap-worker-out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss",
            env: { NODE_ENV: "production" }
        }
    ]
};