# Security Policy

## Design principles

This MCP server opens the Quicken database in **read-only mode** (`SQLITE_OPEN_READONLY`). It cannot modify, delete, or corrupt your financial data.

The `raw_query` tool only permits `SELECT` statements (enforced by checking the query prefix). No writes, DDL, or pragmas that could alter the database are allowed.

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |

## Reporting a vulnerability

If you discover a security issue, please **do not** open a public GitHub issue.

Instead, email **david@weekly.org** with:
- A description of the vulnerability
- Steps to reproduce
- Any potential impact

You should receive a response within 72 hours. We will work with you to understand the issue and coordinate a fix before any public disclosure.
