-- RDS does not inherit the local postgres-init default privileges. Keep the
-- restricted runtime role able to use tables created by later migrations.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hp_app') THEN
    GRANT USAGE ON SCHEMA public TO hp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hp_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hp_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO hp_app;

    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hp_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO hp_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO hp_app;
  END IF;
END;
$$;
