module.exports = {
    apps: [
        {
            name: "pdf-api-server",
            script: "./src/server.js",
            instances: 1,
            exec_mode: "cluster",
            combine_logs: true,
            merge_logs: true,
            error_file: "./logs/api-sensor.log",
            out_file: "./logs/api-sensor.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss",
            env: { NODE_ENV: "production" }
        },
        {
            name: "pdf-worker",
            script: "./src/jobs/worker.js",
            instances: 3,
            exec_mode: "cluster",
            combine_logs: true,
            merge_logs: true,
            error_file: "./logs/worker.log",
            out_file: "./logs/worker.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss",
            max_memory_restart: "2G",
            env: { NODE_ENV: "production" }
        },
        {
            name: "gmail-scanner",
            script: "./src/jobs/gmail_poll.js",
            combine_logs: true,
            error_file: "./logs/gmail.log",
            out_file: "./logs/gmail.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss",
            env: { NODE_ENV: "production" }
        }
    ]
};