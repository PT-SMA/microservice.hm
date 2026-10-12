import {
  CreationOptional,
  InferAttributes,
  InferCreationAttributes,
  Model,
  Sequelize,
} from "sequelize";

export type SequelizeNullishString = CreationOptional<string | null>;
export type SequelizeNullishNumber = CreationOptional<number | null>;
export type SequelizeNullishBool = CreationOptional<boolean | null>;

/**
 * Base type for creating sequelize models
 * example:
 * ```typescript
 * export interface ExampleModel extends SequelizeModels<ExampleModel> {
 *    id: DataTypes.INT
 * }
 * ```
 * also don't forget to export Model's instance type as written like this:
 * ```typescript
 * export type ExampleInstance = ModelCtor<ExampleModel>;
 * ```
 */
export type SequelizeModels<T extends Model> =
  & Model<
    InferAttributes<T>,
    InferCreationAttributes<T>
  >
  & {
    created_at: string;
    updated_at: SequelizeNullishString;
  };

/**
 * Everything `createModels()` returns. Add each model's ctor here as it is
 * created, e.g. `Example: ExampleInstance;`
 */
export type TModelInstances = {
  sequelize: Sequelize;
};
