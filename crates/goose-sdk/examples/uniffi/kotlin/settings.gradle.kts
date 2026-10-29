pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenLocal()
        mavenCentral()
    }
}

rootProject.name = "goose-sdk-kotlin-smoke-test"

// Resolve io.github.aaif-goose:gdk from the in-repo Maven project. Maven Central
// lags the Cargo.toml version (for example 0.1.0-alpha.12 is unpublished there).
includeBuild("../../../maven") {
    dependencySubstitution {
        substitute(module("io.github.aaif-goose:gdk")).using(project(":"))
    }
}
