mod colima;

use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct Operations(Arc<Mutex<()>>);

async fn read<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

async fn mutate(
    operations: Operations,
    work: impl FnOnce() -> Result<colima::OperationResult, String> + Send + 'static,
) -> Result<colima::OperationResult, String> {
    read(move || {
        let _guard = operations
            .0
            .try_lock()
            .map_err(|_| "別の操作が実行中です。完了してから再実行してください。".to_string())?;
        work()
    })
    .await
}

#[tauri::command]
async fn environment() -> Result<colima::Environment, String> {
    read(colima::environment).await
}

#[tauri::command]
async fn list_profiles() -> Result<Vec<colima::Profile>, String> {
    read(colima::list_profiles).await
}

#[tauri::command]
async fn mutate_profile(
    request: colima::ProfileRequest,
    operations: tauri::State<'_, Operations>,
) -> Result<colima::OperationResult, String> {
    mutate(operations.inner().clone(), move || {
        colima::mutate_profile(request)
    })
    .await
}

#[tauri::command]
async fn list_containers(profile: String) -> Result<Vec<colima::Container>, String> {
    read(move || colima::list_containers(profile)).await
}

#[tauri::command]
async fn mutate_container(
    request: colima::ContainerRequest,
    operations: tauri::State<'_, Operations>,
) -> Result<colima::OperationResult, String> {
    mutate(operations.inner().clone(), move || {
        colima::mutate_container(request)
    })
    .await
}

#[tauri::command]
async fn container_logs(profile: String, id: String) -> Result<String, String> {
    read(move || colima::container_logs(profile, id)).await
}

pub fn run() {
    let builder = tauri::Builder::default().manage(Operations::default());

    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .invoke_handler(tauri::generate_handler![
            environment,
            list_profiles,
            mutate_profile,
            list_containers,
            mutate_container,
            container_logs
        ])
        .run(tauri::generate_context!())
        .expect("Colima GUI could not start");
}
