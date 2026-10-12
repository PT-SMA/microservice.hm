import { Sequelize } from "sequelize";
import pg from "pg";
import { TModelInstances } from "types";
import {
  DB_DIALECT,
  DB_HOST,
  DB_NAME,
  DB_PASSWORD,
  DB_POOL_MAX,
  DB_PORT,
  DB_USER,
} from "consts";

// Single shared Sequelize instance (and connection pool) per process —
// every caller gets the same models regardless of where createModels() runs.
let instance: TModelInstances | null = null;

export function createModels(): TModelInstances {
  if (instance) return instance;

  const sequelize = new Sequelize({
    dialect: DB_DIALECT,
    username: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    host: DB_HOST,
    port: DB_PORT,
    define: {
      createdAt: "created_at",
      updatedAt: "updated_at",
      deletedAt: "deleted_at",
      underscored: true,
      paranoid: true,
    },
    dialectModule: pg,
    logging: false,
    pool: {
      max: DB_POOL_MAX,
      min: 0,
      acquire: 30000,
      idle: 10000,
    },
  });

  instance = {
    sequelize,
  };

  return instance;
}
