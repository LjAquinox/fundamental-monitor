import { companyResponseContract } from "./company-response-contract";
import { reportSchema as extractionSchema } from "./report-contract";
import { discoverySchema } from "./report-discovery";
import { forecastSchema } from "./provider";
import { modelJsonSchema } from "./structured-output";

export const modelContracts = {
  extraction: extractionSchema,
  discovery: discoverySchema,
  forecast: forecastSchema,
};
// Company review is input-dependent. Its sole request contract is this factory,
// not the normalized storage envelope in report-contract.ts. Runtime compiles
// the exact generated schema before reserving or sending the model request.
export const dynamicModelContracts = {
  companyReconciliation: companyResponseContract,
};
/** Build checks for static request contracts; dynamic inputs are checked per call. */
export function checkModelContracts() {
  return Object.keys(modelContracts).map((name) => {
    modelJsonSchema(modelContracts[name as keyof typeof modelContracts]);
    return name;
  });
}
