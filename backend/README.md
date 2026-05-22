# Tech R&D Copilot Backend

## Suggested Structure

```text
backend/
  app/
    api/
      v1/
        endpoints/
          chat.py
        router.py
    application/
      workflows/
    core/
      config.py
    domain/
      chat/
        schemas.py
    infrastructure/
      db/
        session.py
      llm/
        factory.py
    shared/
      exceptions/
        base.py
    main.py
```

## Run

```bash
uvicorn app.main:app --reload --app-dir backend
```
