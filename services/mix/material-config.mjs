// Remix originals have their own bucket; credentials may be shared with the asset library.
export function mixMaterialEnvironment(env) {
  const ownCredentials = env.MIX_MATERIAL_COS_SECRET_ID?.trim() || env.MIX_MATERIAL_COS_SECRET_KEY?.trim();
  return { ...env,
    MIX_MATERIAL_COS_SECRET_ID: ownCredentials ? env.MIX_MATERIAL_COS_SECRET_ID : env.COS_SECRET_ID,
    MIX_MATERIAL_COS_SECRET_KEY: ownCredentials ? env.MIX_MATERIAL_COS_SECRET_KEY : env.COS_SECRET_KEY,
    MIX_MATERIAL_COS_BUCKET: env.MIX_MATERIAL_COS_BUCKET?.trim() || 'hj-1410143389',
    MIX_MATERIAL_COS_REGION: env.MIX_MATERIAL_COS_REGION?.trim() || env.COS_REGION,
  };
}
