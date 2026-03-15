/**
 * list_categories tool — List all Quicken category tags.
 *
 * Queries the ZTAG table for CategoryTag entities (Z_ENT looked up at runtime).
 * Categories form a two-level hierarchy: parent categories (e.g., "Food & Dining")
 * and subcategories (e.g., "Groceries", "Restaurants") linked via ZPARENTCATEGORY.
 * ZTYPE distinguishes expense (1) from income (2) categories.
 */

import type Database from "better-sqlite3";
import { getCategoryTagEntityId } from "../db.js";

export function listCategories(db: Database.Database, args: { type?: string }) {
  const categoryTagEntityId = getCategoryTagEntityId(db);
  let sql = `
    SELECT
      c.Z_PK as id,
      c.ZNAME as name,
      c.ZINTERNALNAME as internal_name,
      CASE c.ZTYPE WHEN 1 THEN 'expense' WHEN 2 THEN 'income' ELSE 'other' END as type,
      p.ZNAME as parent_category
    FROM ZTAG c
    LEFT JOIN ZTAG p ON c.ZPARENTCATEGORY = p.Z_PK
    WHERE c.Z_ENT = ${categoryTagEntityId}
  `;
  const params: number[] = [];

  if (args.type === "expense") {
    sql += " AND c.ZTYPE = ?";
    params.push(1);
  } else if (args.type === "income") {
    sql += " AND c.ZTYPE = ?";
    params.push(2);
  }

  // Sort by parent category first (top-level categories group together),
  // then by subcategory name within each group.
  sql += " ORDER BY COALESCE(p.ZNAME, c.ZNAME), c.ZNAME";

  return db.prepare(sql).all(...params);
}
