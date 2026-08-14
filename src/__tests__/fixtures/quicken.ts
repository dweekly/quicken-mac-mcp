import Database from "better-sqlite3";
import { isoToCoreData } from "../../db.js";

/**
 * Build a small, synthetic Quicken-shaped database for deterministic tests.
 * It contains no user data and intentionally includes split, transfer,
 * report-excluded, cash-account, and end-date edge cases.
 */
export function createSyntheticQuickenDb(filename = ":memory:"): Database.Database {
  const db = new Database(filename);

  db.exec(`
    CREATE TABLE Z_METADATA (Z_VERSION INTEGER);
    CREATE TABLE Z_PRIMARYKEY (Z_NAME TEXT, Z_ENT INTEGER);
    CREATE TABLE ZACCOUNT (
      Z_PK INTEGER PRIMARY KEY,
      ZNAME TEXT,
      ZTYPENAME TEXT,
      ZCURRENCY TEXT,
      ZACTIVE INTEGER,
      ZCLOSED INTEGER,
      ZONLINEBANKINGLEDGERBALANCEAMOUNT REAL,
      ZONLINEBANKINGLEDGERBALANCEDATE REAL,
      ZONLINEBANKINGLASTCONNECTEDTIMESTAMP REAL
    );
    CREATE TABLE ZUSERPAYEE (Z_PK INTEGER PRIMARY KEY, ZNAME TEXT);
    CREATE TABLE ZTAG (
      Z_PK INTEGER PRIMARY KEY,
      Z_ENT INTEGER,
      ZNAME TEXT,
      ZPARENTCATEGORY INTEGER
    );
    CREATE TABLE ZTRANSACTION (
      Z_PK INTEGER PRIMARY KEY,
      ZACCOUNT INTEGER,
      ZUSERPAYEE INTEGER,
      ZPOSTEDDATE REAL,
      ZENTEREDDATE REAL,
      ZNOTE TEXT,
      ZAMOUNT REAL,
      ZTARGETACCOUNT INTEGER,
      ZSENDACCOUNT INTEGER,
      ZEXCLUDEFROMREPORTS INTEGER
    );
    CREATE TABLE ZCASHFLOWTRANSACTIONENTRY (
      Z_PK INTEGER PRIMARY KEY,
      ZPARENT INTEGER,
      ZCATEGORYTAG INTEGER,
      ZAMOUNT REAL,
      ZNOTE TEXT,
      ZTRANSFER TEXT,
      ZSEQUENCENUMBER INTEGER
    );
    CREATE TABLE ZFISTATEMENT (
      Z_PK INTEGER PRIMARY KEY,
      ZACCOUNT INTEGER,
      ZDATEASOF REAL,
      ZMODIFICATIONTIMESTAMP REAL,
      ZAVAILCASH REAL
    );
    CREATE TABLE ZFIPOSITION (
      Z_PK INTEGER PRIMARY KEY,
      ZFISTATEMENT INTEGER,
      ZMARKETVALUE REAL
    );
    CREATE TABLE ZPOSITION (
      Z_PK INTEGER PRIMARY KEY,
      ZSECURITY INTEGER,
      ZACCOUNT INTEGER
    );
    CREATE TABLE ZLOT (
      Z_PK INTEGER PRIMARY KEY,
      ZPOSITION INTEGER,
      ZLATESTUNITS REAL,
      ZLATESTCOSTBASIS REAL
    );
    CREATE TABLE ZSECURITY (
      Z_PK INTEGER PRIMARY KEY,
      ZNAME TEXT,
      ZTICKER TEXT
    );
    CREATE TABLE ZSECURITYQUOTE (
      Z_PK INTEGER PRIMARY KEY,
      ZSECURITY INTEGER,
      ZCLOSINGPRICE REAL,
      ZQUOTEDATE REAL
    );
    CREATE TABLE ZBUDGET (
      Z_PK INTEGER PRIMARY KEY,
      ZNAME TEXT,
      ZCURRENCY TEXT,
      ZSTARTMONTH INTEGER,
      ZSHOWCENTS INTEGER,
      ZDELETIONCOUNT INTEGER
    );
    CREATE TABLE ZBUDGETLINEITEM (
      Z_PK INTEGER PRIMARY KEY,
      ZBUDGET INTEGER,
      ZCATEGORYTAG INTEGER,
      ZACCOUNT INTEGER,
      ZISTRANSFEROUT INTEGER,
      ZROLLOVER INTEGER,
      ZTYPE INTEGER
    );
    CREATE TABLE ZBUDGETTARGET (
      Z_PK INTEGER PRIMARY KEY,
      ZLINEITEM INTEGER,
      ZEFFECTIVEDATENUM INTEGER,
      ZAMOUNT REAL,
      ZROLLOVERRESETAMT REAL
    );
    CREATE TABLE ZQUICKFILLRULE (
      Z_PK INTEGER PRIMARY KEY,
      ZPAYEENAME TEXT,
      ZTRANSACTIONTYPE INTEGER,
      ZAMOUNT REAL,
      ZMEMO TEXT,
      ZNEVERAUTOCATEGORIZE INTEGER,
      ZUSEFORDOWNLOADEDTRANSACTIONS INTEGER,
      ZDELETIONCOUNT INTEGER,
      ZLASTUSEDTIMESTAMP REAL
    );
    CREATE TABLE ZQUICKFILLRULESPLITENTRY (
      Z_PK INTEGER PRIMARY KEY,
      ZQUICKFILLRULE INTEGER,
      ZSEQUENCENUMBER INTEGER,
      ZCATEGORYTAG INTEGER,
      ZAMOUNT REAL,
      ZMEMO TEXT
    );
    CREATE TABLE Z_15USERTAGS (
      Z_15CASHFLOWTRANSACTIONENTRIES INTEGER,
      Z_76USERTAGS INTEGER
    );
  `);

  const noon = (date: string) => isoToCoreData(`${date}T12:00:00Z`);
  const midnight = (date: string) => isoToCoreData(`${date}T00:00:00Z`);

  db.prepare("INSERT INTO Z_METADATA VALUES (?)").run(1);
  const insertEntity = db.prepare("INSERT INTO Z_PRIMARYKEY VALUES (?, ?)");
  insertEntity.run("CashFlowTransactionEntry", 15);
  insertEntity.run("UserTag", 76);
  insertEntity.run("CategoryTag", 79);

  const insertAccount = db.prepare(
    "INSERT INTO ZACCOUNT VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  insertAccount.run(
    1,
    "Checking",
    "CHECKING",
    "USD",
    1,
    0,
    1000,
    noon("2024-01-31"),
    noon("2024-02-01")
  );
  insertAccount.run(
    2,
    "Card",
    "CREDITCARD",
    "USD",
    1,
    0,
    -20,
    noon("2024-01-31"),
    noon("2024-02-01")
  );
  insertAccount.run(3, "Wallet", "CASH", "USD", 1, 0, null, null, null);

  db.exec(`
    INSERT INTO ZUSERPAYEE VALUES (1, 'Merchant'), (2, 'Transfer');
    INSERT INTO ZTAG VALUES
      (10, 79, 'Food', NULL),
      (11, 79, 'Groceries', 10),
      (12, 79, 'Dining', 10),
      (20, 76, 'Reviewed', NULL);
  `);

  const insertTransaction = db.prepare(
    "INSERT INTO ZTRANSACTION VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  insertTransaction.run(100, 1, 1, noon("2024-01-31"), null, null, -100, null, null, 0);
  insertTransaction.run(101, 1, 2, noon("2024-01-30"), null, null, -25, 2, null, 0);
  insertTransaction.run(102, 1, 1, noon("2024-01-30"), null, null, -30, null, null, 1);
  insertTransaction.run(103, 1, 2, noon("2024-01-30"), null, null, -35, null, null, 0);
  insertTransaction.run(104, 1, 1, noon("2024-02-01"), null, null, -10, null, null, 0);
  insertTransaction.run(105, 1, 1, noon("2024-01-31"), null, null, 500, null, null, 0);
  insertTransaction.run(106, 2, 1, noon("2024-01-31"), null, null, -20, null, null, 0);
  insertTransaction.run(107, 1, 1, midnight("2024-01-31"), null, null, -5, null, null, 0);
  insertTransaction.run(108, 3, 1, noon("2024-01-31"), null, null, -15, null, null, 0);

  const insertSplit = db.prepare(
    "INSERT INTO ZCASHFLOWTRANSACTIONENTRY VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  insertSplit.run(1000, 100, 11, -60, null, null, 1);
  insertSplit.run(1001, 100, 12, -40, null, null, 2);
  insertSplit.run(1002, 101, null, -25, null, null, 1);
  insertSplit.run(1003, 102, 11, -30, null, null, 1);
  insertSplit.run(1004, 103, null, -35, null, "transfer", 1);
  insertSplit.run(1005, 104, 11, -10, null, null, 1);
  insertSplit.run(1006, 105, null, 500, null, null, 1);
  insertSplit.run(1007, 106, 11, -20, null, null, 1);
  insertSplit.run(1008, 107, null, -5, null, null, 1);
  insertSplit.run(1009, 108, 11, -15, null, null, 1);

  db.exec(`
    INSERT INTO ZFISTATEMENT VALUES (1, 1, ${noon("2024-01-31")}, ${noon("2024-01-31")}, 25);
    INSERT INTO ZFIPOSITION VALUES (1, 1, 100), (2, 1, 0);
    INSERT INTO ZSECURITY VALUES (1, 'Example Fund', 'EXMPL');
    INSERT INTO ZPOSITION VALUES (1, 1, 1);
    INSERT INTO ZLOT VALUES (1, 1, 2, 150);
    INSERT INTO ZSECURITYQUOTE VALUES (1, 1, 100, ${noon("2024-01-31")});
    INSERT INTO ZBUDGET VALUES (1, 'Household', 'USD', 1, 1, 0);
    INSERT INTO ZBUDGETLINEITEM VALUES (1, 1, 11, NULL, 0, 0, 0);
    INSERT INTO ZBUDGETTARGET VALUES (1, 1, 202401, 500, 0);
    INSERT INTO ZQUICKFILLRULE VALUES (1, 'Merchant', 0, NULL, NULL, 0, 1, 0, ${noon("2024-01-31")});
    INSERT INTO ZQUICKFILLRULESPLITENTRY VALUES (1, 1, 1, 11, NULL, NULL);
    INSERT INTO Z_15USERTAGS VALUES (1000, 20);
  `);

  return db;
}
