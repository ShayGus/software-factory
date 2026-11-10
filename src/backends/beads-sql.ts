/** bd 1.1.0 / Dolt 2.7.2 schema seam. Never execute concatenated BEGIN statements. */
export function sqlString(value: string): string {
  // Hex literals avoid connection-specific quote/backslash SQL modes entirely.
  return `CONVERT(X'${Buffer.from(value, "utf8").toString("hex")}' USING utf8mb4)`;
}

export const EDGES = `(SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
  'id', d.depends_on_issue_id, 'type', d.type)), JSON_ARRAY())
  FROM dependencies d WHERE d.issue_id=i.id)`;

// GROUP_CONCAT has a server length limit: hash each edge, then use JSON_ARRAYAGG
// (unbounded by that limit); ordering follows the dependencies primary key.
export const TOKEN = `SHA2(CAST(JSON_OBJECT('title',i.title,'description',i.description,
  'status',i.status,'priority',i.priority,'metadata',i.metadata,
  'updated_at',i.updated_at,'edges',${EDGES}) AS CHAR),256)`;

export const READ = `SELECT i.id,i.title,i.description,i.status,i.priority,i.metadata,
  ${EDGES} AS edges, ${TOKEN} AS token FROM issues i`;

export const HISTORY_TABLE = `CREATE TABLE IF NOT EXISTS tasks_axi_history_v1 (
  id VARCHAR(36) PRIMARY KEY, physical_id VARCHAR(255) NOT NULL,
  operation VARCHAR(32) NOT NULL, snapshot JSON NOT NULL,
  recorded_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6))`;

/** One CALL is one transaction, including multi-record logical prune. */
export const APPLY_ROUTINE = `CREATE PROCEDURE tasks_axi_apply_v1(IN payload JSON)
BEGIN
  DECLARE entry_index INT DEFAULT 0;
  DECLARE entry_count INT;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tasks-axi transaction refused or conflicted; inspect and retry';
  END;
  SET @tasks_axi_payload=payload;
  SET entry_count=JSON_LENGTH(JSON_EXTRACT(@tasks_axi_payload,'$.entries'));
  START TRANSACTION;
  WHILE entry_index < entry_count DO
    SET @tasks_axi_entry=JSON_EXTRACT(@tasks_axi_payload,CONCAT('$.entries[',entry_index,']'));
    SET @tasks_axi_id=JSON_UNQUOTE(JSON_EXTRACT(@tasks_axi_entry,'$.id'));
    SET @tasks_axi_mode=JSON_UNQUOTE(JSON_EXTRACT(@tasks_axi_entry,'$.mode'));
    SET @tasks_axi_ns=JSON_EXTRACT(@tasks_axi_entry,'$.namespace');
    IF @tasks_axi_mode='create' THEN
      INSERT INTO issues (id,title,description,design,acceptance_criteria,notes,status,priority,issue_type,created_by,metadata,closed_at)
      VALUES (@tasks_axi_id,JSON_UNQUOTE(JSON_EXTRACT(@tasks_axi_ns,'$.task.title')),
        COALESCE(JSON_UNQUOTE(JSON_EXTRACT(@tasks_axi_ns,'$.task.body')),''),'','','',
        JSON_UNQUOTE(JSON_EXTRACT(@tasks_axi_entry,'$.status')),
        COALESCE(JSON_EXTRACT(@tasks_axi_ns,'$.task.priority'),2),'task','tasks-axi',
        JSON_OBJECT('tasks_axi',@tasks_axi_ns),
        IF(JSON_UNQUOTE(JSON_EXTRACT(@tasks_axi_entry,'$.status'))='closed',CURRENT_TIMESTAMP,NULL));
    ELSE
      IF NOT EXISTS(SELECT 1 FROM issues i WHERE i.id=@tasks_axi_id
        AND ${TOKEN}=JSON_UNQUOTE(JSON_EXTRACT(@tasks_axi_entry,'$.token'))) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='stale task snapshot';
      END IF;
      IF @tasks_axi_mode='remove' AND EXISTS(SELECT 1 FROM dependencies d JOIN issues dependent
          ON dependent.id=d.issue_id WHERE d.depends_on_issue_id=@tasks_axi_id
          AND d.type='blocks' AND dependent.status<>'closed') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active dependents';
      END IF;
      INSERT INTO tasks_axi_history_v1(id,physical_id,operation,snapshot)
        SELECT UUID(),i.id,@tasks_axi_mode,JSON_OBJECT('title',i.title,'body',i.description,
          'status',i.status,'metadata',i.metadata,'edges',${EDGES}) FROM issues i WHERE i.id=@tasks_axi_id;
      IF @tasks_axi_mode='remove' THEN
        DELETE FROM issues WHERE id=@tasks_axi_id;
      ELSE
        UPDATE issues SET title=JSON_UNQUOTE(JSON_EXTRACT(@tasks_axi_ns,'$.task.title')),
          description=COALESCE(JSON_UNQUOTE(JSON_EXTRACT(@tasks_axi_ns,'$.task.body')),''),
          status=JSON_UNQUOTE(JSON_EXTRACT(@tasks_axi_entry,'$.status')),
          priority=COALESCE(JSON_EXTRACT(@tasks_axi_ns,'$.task.priority'),2),
          metadata=JSON_SET(metadata,'$.tasks_axi',@tasks_axi_ns),
          closed_at=IF(JSON_UNQUOTE(JSON_EXTRACT(@tasks_axi_entry,'$.status'))='closed',COALESCE(closed_at,CURRENT_TIMESTAMP),NULL),
          updated_at=CURRENT_TIMESTAMP
          WHERE id=@tasks_axi_id;
      END IF;
    END IF;
    IF @tasks_axi_mode<>'remove' THEN
      IF EXISTS(SELECT 1 FROM JSON_TABLE(JSON_EXTRACT(@tasks_axi_entry,'$.edges'),
        '$[*]' COLUMNS(target VARCHAR(255) PATH '$.id', edge_type VARCHAR(32) PATH '$.type')) e
        LEFT JOIN issues target_issue ON target_issue.id=e.target
        WHERE target_issue.id IS NULL OR e.target=@tasks_axi_id
          OR NOT(JSON_EXTRACT(target_issue.metadata,'$.tasks_axi.version') <=> 1)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='missing or foreign dependency';
      END IF;
      DELETE FROM dependencies WHERE issue_id=@tasks_axi_id AND type IN ('blocks','parent-child','discovered-from');
      INSERT INTO dependencies(id,issue_id,depends_on_issue_id,type,created_by)
        SELECT UUID(),@tasks_axi_id,e.target,e.edge_type,'tasks-axi'
        FROM JSON_TABLE(JSON_EXTRACT(@tasks_axi_entry,'$.edges'),
          '$[*]' COLUMNS(target VARCHAR(255) PATH '$.id', edge_type VARCHAR(32) PATH '$.type')) e;
      UPDATE issues SET is_blocked=EXISTS(SELECT 1 FROM dependencies d JOIN issues blocker
        ON blocker.id=d.depends_on_issue_id WHERE d.issue_id=@tasks_axi_id AND d.type='blocks' AND blocker.status<>'closed')
        WHERE id=@tasks_axi_id;
      INSERT INTO tasks_axi_history_v1(id,physical_id,operation,snapshot)
        SELECT UUID(),i.id,CONCAT(@tasks_axi_mode,'-result'),JSON_OBJECT('title',i.title,'body',i.description,
          'status',i.status,'metadata',i.metadata,'edges',${EDGES}) FROM issues i WHERE i.id=@tasks_axi_id;
    END IF;
    SET entry_index=entry_index+1;
  END WHILE;
  UPDATE issues target_issue SET is_blocked=EXISTS(SELECT 1 FROM dependencies d JOIN issues blocker
    ON blocker.id=d.depends_on_issue_id WHERE d.issue_id=target_issue.id AND d.type='blocks' AND blocker.status<>'closed');
  COMMIT;
END`;
