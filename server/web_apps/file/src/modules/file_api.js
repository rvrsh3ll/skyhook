/* global skyB64 skyStob skyBtos skyMd5Sum RunObfs algos_wasm wasm_exec wasm_helpers wasm_worker */
/* exported skyB64 skyStob skyBtos skyMd5Sum RunObfs algos_wasm wasm_exec wasm_helpers wasm_worker */

import axios from "axios";
import jwtDecode from "jwt-decode";
import {wait} from "./waiter";

export var API_URIS = {
    "/landing": "/landing",
    "/login": "/login",
    "/logout": "/logout",
    "/download": "/files",
    "/upload": "/upload"
};

//======================================
// CONFIGURE RETRIES FOR FAILED REQUESTS
//======================================

// https://codepen.io/bitbug/pen/wvmreeY
axios.interceptors.response.use(undefined, (err) => {
    const { config, message } = err;
    if(config.retry && (message.includes("timeout") || message.includes("Network Error"))) {
        config.retry-=1;
        if(config.retry === 0){
            console.log('Retrying request for the final time')
        } else {
            console.log('Retrying failed request');
        }
        const delayRetryRequest = new Promise((resolve) => {
            setTimeout(() => {
                console.log("retry the request", config.url);
                resolve();
            }, config.retryDelay || 1000);
        });
        return delayRetryRequest.then(() => axios(config));
    } else {
        return Promise.reject(err);
    }
});

/*
request is a method decorator for API calls that accepts
an HTTP method and URI to generate a request to the admin API
of a Skyhook deployment.

# Base URL

The base URL for the request is read from the instance's base_url
property.

Trailing slashes are removed from the URL prior to the request.

# Output Object

Callers to the decorated class methods receive a consistent
object in the form of:

{
  ok: boolean,
  resp: axios.response,
  output: object,
}

Where output is any additional output generated by the decorated
class method.
 */
function request(httpMethod, uri) {
    function outer(target) {
        async function decorator(data, url_params, headers, obf_config, do_deobf, out_type) {

            if(do_deobf === undefined){ do_deobf=true }
            if(out_type === undefined){ out_type="json" }
            let reqUri = API_URIS[uri];
            try {

                //======================
                // CHECK THE HTTP METHOD
                //======================

                if (axios[httpMethod] === undefined) {
                    throw new Error(`Invalid HTTP method supplied: ${httpMethod}`);
                }

                //===========================
                // TRIM SLASHES FROM BASE URL
                //===========================

                let base_url = (this.base_url === undefined ? "" : this.base_url)
                if(base_url[base_url.length-1]==="/"){
                    let i=base_url.length-1;
                    for(i; i>=0; i--){
                        if(base_url[i] !== "/"){
                            break
                        }
                        base_url=base_url.slice(0, i)
                    }
                }

                //======================
                // MANAGE URL PARAMETERS
                //======================
                // TODO this is terrible design
                // If the data contains a url_params array attribute, consider it
                // to contain a series of URL parameters for the current request.
                //
                // This allows for callers to manipulate the requested URL.
                //
                // This is a "just make it work" adaption from admin_api.

                if(url_params && url_params.length) {
                    if(!Array.isArray(url_params)){
                        throw new Error('url_params must be an array of obfuscated strings')
                    }

                    //=========================
                    // OBFUSCATE URL PARAMETERS
                    //=========================

                    let finished=0;
                    const worker = new Worker(wasm_worker);
                    for(let i=0; i<url_params.length; i++) {
                        // eslint-disable-next-line
                        worker.onmessage = (e) => {
                            url_params[e.data.addtl]=e.data.output;
                            finished+=1;
                        }
                        worker.postMessage({
                            wasm_exec: wasm_exec,
                            algos_wasm: algos_wasm,
                            wasm_helpers: wasm_helpers,
                            func: "RunObfs",
                            args: ["obf", url_params[i], obf_config],
                            bytefi_in: [1],
                            stringify_out: true,
                            addtl: i
                        })
                    }
                    while(finished !== url_params.length){
                        await wait(50)
                    }
                    worker.terminate();
                    reqUri += '/'+url_params.join('/')
                }

                //=======================
                // MANAGE REQUEST HEADERS
                //=======================
                // TODO this is terrible design
                // If the data payload has a "headers" field, incorporate it
                // into the headers for the request.
                //
                // This allows the caller to include a Range header
                //
                // This is a "just make it work" adaption from admin_api.

                let _headers = this.headers()
                if(headers){
                    Object.assign(_headers, headers)
                }

                //=================
                // MAKE THE REQUEST
                //=================

                let resp;
                resp = await axios.request({
                    url: base_url + reqUri,
                    method: httpMethod,
                    headers: _headers,
                    data: data,
                    withCredentials: false,
                    retry: 3,
                })


                //     .catch((e) => {
                //     return {output:{
                //         success: false,
                //         alert: {
                //             variant: "danger",
                //             heading: "HTTP Request Failure",
                //             message: `Error Message: ${e.message}`,
                //             timeout: 10}}};
                // });

                //==================================
                // DEOBFUSCATE OUTPUT WHEN REQUESTED
                //==================================
                // TODO this is more terrible design
                // When config parameters are provided, deobfuscate the
                // output before sending it to the decorated method

                let deobf_finished=false;
                if(resp.data && obf_config && do_deobf){

                    const worker = new Worker(wasm_worker);

                    worker.onmessage = (e) => {
                        worker.terminate();
                        if(e.data.output_conv_failure){
                            deobf_finished=e.data.output_conv_failure;
                        }else if(e.data.input_conv_failure){
                            deobf_finished=e.data.input_conv_failure;
                        }else {
                            resp.data = e.data.output;
                            deobf_finished = true;
                        }
                    }

                    worker.postMessage({
                        wasm_exec: wasm_exec,
                        algos_wasm: algos_wasm,
                        wasm_helpers: wasm_helpers,
                        func: "RunObfs",
                        args: ["deobf", resp.data, obf_config],
                        bytefi_in: [1],
                        jsonify_out: out_type === "json",
                        stringify_out: out_type === "string",
                    })

                    while(!deobf_finished){await wait(50)}

                }

                if(typeof(deobf_finished) === 'string'){
                    throw new Error(deobf_finished)
                }

                //=================================
                // CALL DECORATED METHOD FOR OUTPUT
                //=================================

                let output = target.call(this, data, resp)

                //==================
                // RETURN THE OUTPUT
                //==================

                return {
                    ok: resp.status === 200,
                    resp: resp,
                    output: output
                }

            } catch (e) {

                console.log(`Decorator failed to execute method ${target.name}: ${e}`)
                throw e;

            }
        }
        return decorator;
    }
    return outer;
}

export class FileApi {

    constructor(base_url, headers, realm, username_field_name, admin_field_name, auth_header_name, auth_header_scheme){

        this.mgr = new AuthMgr(this, "json_token", "jwt", "token")
        this.token = this.mgr.token;

        this.base_url = (!base_url ? window.location.origin : base_url)
        this._headers = (headers === undefined ? {} : headers)
        this._headers = Object.assign(this.headers, {
            "Accept": "application/json",
        })

        //=============================
        // SET JWT & AUTH HEADER FIELDS
        //=============================

        let api_config = localStorage.getItem("api_config")
        if(api_config){
            api_config = JSON.parse(api_config);
            this.setApiConfig(api_config);
            this.setApiUris(api_config);
        } else {
            this.realm_value = (!realm ? "sh" : realm)
            this.username_field_name = (!realm ? "id" : username_field_name)
            this.admin_field_name = (!admin_field_name ? "ad" : admin_field_name)
            this.auth_header_name = (!auth_header_name ? "Authorization" : auth_header_name)
            this.auth_header_scheme = (!auth_header_scheme ? "Bearer" : auth_header_scheme)
            this.range_header_name = "Range"
            this.range_prefix = "bytes"
        }

        //============================================
        // METHOD BINDINGS (OR WHATEVER THIS TRASH IS)
        //============================================

        this.postLogin = this.postLogin.bind(this);
        this.postLogout = this.postLogout.bind(this);
        this.getRefreshToken = this.getRefreshToken.bind(this);
        this.downloadFileChunk = this.downloadFileChunk.bind(this);
        this.inspectFiles = this.inspectFiles.bind(this);
        this.registerUpload = this.registerUpload.bind(this);
        this.uploadFinished = this.uploadFinished.bind(this);
        this.putFileChunk = this.putFileChunk.bind(this);
        this.cancelUpload = this.cancelUpload.bind(this);
        this.loadAuthConfig = this.loadAuthConfig.bind(this);
        this.setApiConfig = this.setApiConfig.bind(this);
        this.setApiUris = this.setApiUris.bind(this);
    }

    headers(){
        let headers = Object.assign({}, this._headers)
        if(this.token !== "") {
            headers[this.auth_header_name] = `${this.auth_header_scheme} ${this.token}`
        }
        return headers
    }

    setApiUris(api_config){
        let keys = Object.keys(api_config.api_routes);
        for(let i = 0; i<keys.length; i++){
            API_URIS["/"+keys[i]] = api_config.api_routes[keys[i]]
        }
    }

    setApiConfig(api_config){
        this.realm_value = api_config.auth_config.jwt.realm;
        this.username_field_name = api_config.auth_config.jwt.username;
        this.admin_field_name = api_config.auth_config.jwt.admin;
        this.auth_header_name = api_config.auth_config.header.name;
        this.auth_header_scheme = api_config.auth_config.header.scheme;
        this.range_header_name = api_config.upload_config.range_header_name;
        this.range_prefix = api_config.upload_config.range_prefix;
    }

    loadAuthConfig(key) {
        key = key ? key : "auth_config";
        let auth_config = localStorage.getItem(key);
        auth_config = JSON.parse(auth_config);
        this.realm_value = auth_config.jwt.realm;
        this.username_field_name = auth_config.jwt.field_keys.username;
        this.admin_field_name = auth_config.jwt.field_keys.admin;
        this.auth_header_name = auth_config.header.name;
        this.auth_header_scheme = auth_config.header.scheme;
    }

    //=====================
    // AUTHENTICATION CALLS
    //=====================

    @request("post", "/login")
    postLogin(data, resp){
        let alert;
        if(resp.status === 200){

            this.token = resp.data.token;
            let api_config = this.mgr.jwtDecodeToken(this.token);
            if(api_config){
                this.setApiConfig(api_config);
                this.setApiUris(api_config);
                this.mgr.updateStoredTokens(resp.data);
            }

            alert = {variant:"success",
                heading: "",
                message: "Login successful",
                timeout: 5}

        } else {
            alert = {
                variant: "warning",
                heading: "",
                message: "Login failure",
                timeout: 5
            }
        }
        return {
            token: data,
            alert: alert
        }
    }

    @request("get", "/login")
    getRefreshToken(data, response){
        let alert;
        if(response.status !== 200){
            alert = {
                variant: "danger",
                heading: "",
                message: "Failed to refresh login token",
                timeout: 10,
            }
        }
        return {
            token: response.data,
            alert: alert
        }
    }

    @request("post", "/logout")
    postLogout(data, response){
        let alert = {
            variant: "success",
            heading: "",
            message: "Logout sucessful.",
            timeout: 10,
            show: true,
        }
        if(response.status === 200){
            this.mgr.clearStoredTokens()
        } else {
            alert = {
                variant: "danger",
                message: "Logout failed.",
                timeout: 10,
                show: true,
            }
        }
        return {alert: alert}
    }

    //====================
    // FILE DOWNLOAD CALLS
    //====================

    // NOTE URL parameter to specify file AND range header is managed by decorator.
    @request("get", "/download")
    downloadFileChunk(data, response) {
        if(response.status === 206){
            return {
                success: true,
                chunk: response.data,
            }
        } else {
            return {
                success: false,
                alert: {
                    variant: "danger",
                    heading: "Failed to Retrieve File Chunk",
                    message: `HTTP status code: ${response.status}`,
                    timeout: 5,
                    show: true,
                }
            }
        }
    }

    // NOTE URL parameter to specify file is managed by decorator.
    @request("patch", "/download")
    inspectFiles(data, response) {
        if(response.status === 200){
            return {
                success: true,
                listing: response.data.entries,
            }
        }else{
            return {
                success: false,
                alert: {
                    variant: "danger",
                    heading: "Failed to Retrieve File Listing",
                    message: `HTTP status code: ${response.status}`,
                    timeout: 5,
                    show: true,
                }
            }
        }
    }


    //==================
    // FILE UPLOAD CALLS
    //==================

    @request("get", "/upload")
    listUploads(data, response){
        if(response.status === 200){
            return {
                success: true,
                uploads: response.data.uploads
            }
        } else {
            return {
                success: false,
                alert: {
                    variant: "danger",
                    heading: "Failed to Retrieve Upload Listing",
                    message: `HTTP status code: ${response.status}`,
                    timeout: 5,
                    show: true
                }
            }
        }
    }

    // NOTE URL parameter to specify file is managed by decorator.
    @request("put", "/upload")
    registerUpload(data, response) {
        if(response.status === 200){
            return {success: true}
        }else{
            return {
                success: false,
                alert: {
                    variant: "danger",
                    heading: "Failed to Register Upload",
                    message: `HTTP status code: ${response.status}`,
                    timeout: 5,
                    show: true
                }
            }
        }
    }

    // NOTE URL parameter to specify file is managed by decorator.
    @request("patch", "/upload")
    uploadFinished(data, response) {
        if(response.status === 200){
            return {success: true}
        } else {
            return {
                success: false,
                alert: {
                    variant: "danger",
                    heading: "Failed to Finish Upload",
                    message: `HTTP status code: ${response.status}`,
                    timeout: 5,
                    show: true
                }
            }
        }
    }

    // NOTE URL parameter to specify file AND range header is managed by decorator.
    @request("post", "/upload")
    putFileChunk(data, response) {
        if(response.status === 200){
            return {success: true}
        } else {
            return {
                success: false,
                alert: {
                    variant: "danger",
                    heading: "Failed to Send Upload Chunk",
                    message: `HTTP status code: ${response.status}`,
                    timeout: 5,
                    show: true
                }
            }
        }
    }

    // NOTE URL parameter to specify file is managed by decorator.
    @request("delete", "/upload")
    cancelUpload(data, response) {
        if(response.status === 200){
            return {success: true}
        } else {
            return {
                success: false,
                alert: {
                    variant: "danger",
                    heading: "Failed to Cancel Upload",
                    message: `HTTP status code: ${response.status}`,
                    timeout: 5,
                    show: true
                }
            }
        }
    }
}

class AuthMgr {

    constructor(admin, json_storage_key, jwt_storage_key, token_storage_key){

        // this.admin is a reference to AdminApi, allowing us to
        // make the necessary API calls to refresh the token.
        this.admin = admin;

        // this.jwt is the decoded token
        this.jwt = null;

        // this.token is the raw string token (unencoded)
        this.token = null;

        // this.json_storage_key is the key used to pull the token
        // from local storage.
        this.json_storage_key = json_storage_key;

        // this.jwt_storage_key is the storage key for the decoded
        // JWT value.
        this.jwt_storage_key = jwt_storage_key;

        // this.token_storage_key is the storage key for the
        // string token value used for authentication.
        this.token_storage_key = token_storage_key;

        //==============================================
        // RETRIEVE JSON STRING TOKEN FROM LOCAL STORAGE
        //==============================================

        let jsonToken = localStorage.getItem(this.json_storage_key);
        if(jsonToken){
            try {
                jsonToken = JSON.parse(jsonToken);
                this.jwtDecodeToken(jsonToken.token)
            } catch(e) {
                console.log("Failed to parse JSON token from local storage.")
                console.log(e);
            }

            // NOTE: No token indicates that authentication should occur
            jsonToken = "";
        }

        //=========================================================
        // CONFIGURE EVENT LISTENER TO PULL NEW TOKENS FROM STORAGE
        //=========================================================

        window.addEventListener("storage", this.storageListener);
        setInterval(this.checkTokenExpiry, 60000);
    }

    async checkTokenExpiry(){
        if(!this.token){
            return
        }
        
        if(this.jwt != null){
            if(this.jwt.exp < (Date.now() - 1000 * 60 * 5) / 1000){
                let out = await this.admin.getRefreshToken();
                if(!out.ok){
                    // TODO alert on this event somehow
                    console.log(`Failed to refresh token`)
                    this.clearStoredTokens();
                } else {
                    this.admin.token = out.output.token.token;
                    this.updateStoredTokens(out.output.token);
                }
            }
        }
    }

    /*
    updateJsonStorageToken sets newToken in local storage when it has a value,
    otherwise the current token is removed from storage.
     */
    updateStoredTokens(newToken){
        if(newToken){
            let jToken;
            try {
                jToken = JSON.stringify(newToken);
            } catch(e) {
                console.log(`Failed to parse new JSON token: ${e}`);
                throw e;
            }
            localStorage.setItem(this.json_storage_key, jToken);
            localStorage.setItem(this.token_storage_key, newToken.token);
        } else {
            localStorage.removeItem(this.json_storage_key);
        }
    }

    clearStoredTokens(){
        this.token=null;
        this.admin.token=null;
        localStorage.removeItem(this.json_storage_key);
        localStorage.removeItem(this.token_storage_key);
    }

    storageListener(event){

        // Ensure the event is related to the token
        if(event.key !== this.json_storage_key){
            return
        }

        // Disregard empty tokens
        let json = event.newValue;
        if(!json){
            return
        }

        // Parse the token into an object from JSON
        try {
            json = JSON.parse(json)
        } catch(e) {
            console.log(`Failed to parse JWT token written to local storage: ${e}`);
            // TODO send an error alert
            return
        }

        // JWT decode the token and set it as an instance attribute
        if(this.jwtDecodeToken(json.token)){
            // If successful, pass it to update token
            this.updateStoredTokens(json);
        }
    }

    jwtDecodeToken(token){

        if(typeof(token) !== "string"){
            console.log("jwtDecodeToken expects a string.")
            return
        }

        // JWT decode the token
        let config;
        try{
            this.jwt = jwtDecode(token);

            //===========================================
            // DECRYPT THE REQUESTS CONFIG FROM THE TOKEN
            //===========================================

            let key = new TextEncoder().encode(localStorage.getItem("user_token"))

            let tAttrs = Object.keys(this.jwt);
            for(let i=0; i<tAttrs.length; i++){
                let a = tAttrs[i];
                try{
                    let raw = window.atob(this.jwt[a]);
                    config = new Uint8Array(raw.length);
                    for(let xi=0; xi<raw.length; xi++){
                        config[xi] = raw[xi].charCodeAt(0)^key[xi%key.byteLength]
                    }
                    config = new TextDecoder("utf8").decode(config);
                    config = JSON.parse(config);
                    if(config.obfuscators){
                        let cached = localStorage.getItem("api_config");
                        if(cached){
                            cached = JSON.parse(cached)
                            if(cached.obfuscators && cached.obfuscators.length){
                                config.obfuscators=cached.obfuscators;
                            }
                        }
                        console.log("API config parsed from login response.");
                        console.log("Setting config in local storage.")
                        localStorage.setItem("api_config", JSON.stringify(config));
                        break
                    }
                }catch(e){
                    config="";
                    continue
                }
            }

            if(config === ""){
                throw new Error('Failed to parse API config from JWT token');
            }

            this.token = token;
        }catch(e){
            console.log(`Failed to decode JWT token: ${e}`);
            // TODO send an error alert
            return false;
        }

        return config;
    }
}

let SKYHOOK_SERVER;
if(process.env.NODE_ENV === 'development'){
    SKYHOOK_SERVER=process.env.REACT_APP_SKYHOOK_SERVER;
}
export const fileApi = new FileApi(SKYHOOK_SERVER);