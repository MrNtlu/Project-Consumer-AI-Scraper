# Development Documentation

This repository contains various development resources and documentation for managing Node.js applications and VPS deployments.

## Quick Navigation

- [NPM Commands](node.txt) - Common NPM commands for package management and development
- [VPS Management](vps.txt) - VPS deployment, PM2, and cron job management commands

## NPM Commands Overview

See the [NPM Commands](node.txt) file for a comprehensive list of common npm commands, including:

- Package management
- Security & maintenance
- Running scripts and applications

## VPS Management Overview

Check the [VPS Management](vps.txt) file for detailed information about:

- SSH connection
- PM2 process management
- Cron job scheduling
- Server maintenance commands

## PM2 Quick Reference

Common PM2 commands for process management:

```bash
pm2 start app.js    # Start an application
pm2 status          # Check process status
pm2 logs           # View application logs
pm2 stop all       # Stop all processes
```

## Cron Jobs

Basic cron job management:

```bash
crontab -e         # Edit cron jobs
crontab -l         # List current cron jobs
```

For more detailed information about specific commands and usage, please refer to the respective documentation files linked above.
