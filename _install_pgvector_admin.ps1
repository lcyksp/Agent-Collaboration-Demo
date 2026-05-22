Copy-Item -LiteralPath "D:\AI agent\Agent Collaboration Demo\_pgvector_src\vector.dll" -Destination "C:\Program Files\PostgreSQL\16\lib\vector.dll" -Force
Copy-Item -LiteralPath "D:\AI agent\Agent Collaboration Demo\_pgvector_src\sql\vector.sql" -Destination "C:\Program Files\PostgreSQL\16\share\extension\vector--0.8.2.sql" -Force
Copy-Item -LiteralPath "D:\AI agent\Agent Collaboration Demo\_pgvector_src\vector.control" -Destination "C:\Program Files\PostgreSQL\16\share\extension\vector.control" -Force
