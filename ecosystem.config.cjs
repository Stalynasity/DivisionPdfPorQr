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
            instances: 3, // <--- Aquí activamos tus 3 workers
            exec_mode: "cluster",
            error_file: "./logs/worker-error.log",
            out_file: "./logs/worker-out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss",
            merge_logs: true, // Combina logs de los 3 workers en un solo archivo para fácil lectura
            max_memory_restart: "1500M",
            env: { NODE_ENV: "production" }
        }
    ]
};