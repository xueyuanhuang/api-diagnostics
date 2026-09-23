ALTER TABLE rpm_runs ADD COLUMN openrouter_tier TEXT;
ALTER TABLE availability_targets ADD COLUMN openrouter_tier TEXT;
DROP INDEX availability_target_unique;
CREATE UNIQUE INDEX availability_target_unique ON availability_targets(user_id,profile_id,api_type,model_name,COALESCE(openrouter_tier,''));
