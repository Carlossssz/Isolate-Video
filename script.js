
const areaDeVideo = document.getElementById("areaDeVideo"); //AREA DO VIDEO
const resize = document.getElementById("resize");   //BOTAO DE RESIZE
const areaLink = document.getElementById("areaLink"); //Área onde fica o input de link e o Botão de buscar

var player = null; //player começa como null

//Função executada ao clicar no botão "buscar";
function goVideo() {
    let buscarVideo = document.getElementById("buscarVideo");
    let idDoVideo;

    buscarVideo.addEventListener("click", function () { //Função de clique no botão de buscar
        let linkDoVideo = document.getElementById("linkDoVideo").value;

        let fim = linkDoVideo.indexOf("&");

        idDoVideo = fim === -1
            ? linkDoVideo.substring(32)
            : linkDoVideo.substring(32, fim);

        //Aqui faz uma validação do id recebido, para saber se foi um link do youtube
        function idValido(id) {
            return /^[a-zA-Z0-9_-]{11}$/.test(id);
        }


        if (linkDoVideo) {
            if (!idValido(idDoVideo)) {
                alert("link Inválido!"); //se o id n for válido, nem cria e nem altera o iframe, para n dar erro.
                return;
            }

            //Funções para configurações de inicialização do vídeo;
            function onPlayerReady(event) {
                event.target.playVideo();

                //velocidade
                event.target.setPlaybackRate(2);

                //Qualidade de vídeo hd1080
                event.target.setPlaybackQuality("hd1080");
            }
            if (!player) { //se player for null, no caso, a primeira vez que acessar a página, evitando vídeo vazio, criará o iframe com o id do video passado
                player = new YT.Player("player", {
                    videoId: idDoVideo,
                    events: {
                        onReady: onPlayerReady,
                    },
                    playerVars: {
                        rel: 0,
                        modestbranding: 1,
                        controls: 1
                    }
                });

                alterarBordaDoVideo(); //Adiciona a alternancia de borda ao entrar na área de vídeo
                esconderBorda() //Faz a borda sumir sem precisar entrar na área de video pela primeira vez
            } else {
                player.loadVideoById(idDoVideo); //faz a troca de vídeo sem criar uma nova instância de YT.Player
                alterarBordaDoVideo(); //Adiciona a alternancia de borda ao entrar na área de vídeo
                esconderBorda() //Faz a borda sumir sem precisar entrar na área de video pela primeira vez
            }
        } else {
            alert("Insira um link para buscar um vídeo!");
        }
    });
}



//APARENCIA DA BORDA DO VIDEO
function esconderBorda() {
    setTimeout(() => {
        areaDeVideo.style.boxShadow = "none";
        resize.style.opacity = "0";
    }, 2000); //3800 é a velocidade para o desaparecimendo do menú do youtube

}
function aparecerBorda() {
    areaDeVideo.style.boxShadow = "0 0 20px rgb(68, 68, 68)";
    resize.style.opacity = "100"
}

function alterarBordaDoVideo() {
    areaDeVideo.addEventListener("mousemove", () => {
        aparecerBorda();
    })

    areaDeVideo.addEventListener("mouseleave", () => {
        esconderBorda();
    })

}


//MENU DE VIDEOS
function myVideos() {
    let menuBtn = document.getElementById("menuBtn");
    let menuState = false;
    let menuBox = document.getElementById("menuBox");
    let menu = document.getElementById("menu");

    menuBtn.addEventListener("click", function () {
        if (!menuState) {
            menuBox.style.transform = "translateX(0)"

            menuBtn.style.backgroundColor = "gray";
            menuBtn.style.boxShadow = "none";
            menuBtn.style.backgroundColor = "black";
            menuBtn.style.borderRadius = "10px 0 0 10px"

            //faz o menu ocupar toda a área do menuBox, invadindo a área do menuBtn
            menu.style.width = "100%";

            menuState = true;
        } else {
            menuBox.style.transform = "translateX(calc(-100% + 35px))"

            //remove o css inline aplicado pelo js
            menuBtn.removeAttribute("style");

            //remove o css inline aplicado pelo js
            menu.removeAttribute("style");

            menuState = false;
        }
    })
}


//REDIMENCIONAMENTO DA JANELA DE VIDEO

let botaoResizeApertado = false;
function mover(MouseEvent) {
    const rect = areaDeVideo.getBoundingClientRect();

    areaDeVideo.style.width = `${MouseEvent.clientX - rect.left}px`;
    areaDeVideo.style.height = `${MouseEvent.clientY - rect.top}px`;
}

resize.addEventListener("mousedown", () => { //FUNÇÃO DE C
    document.addEventListener("mousemove", mover);
    botaoResizeApertado = true
    areaLink.style.display = "none";
});

document.addEventListener("mouseup", () => {
    document.removeEventListener("mousemove", mover);
    botaoResizeApertado = false
})


//faz sumir o mouse e a área de pesquisa, após 2s de inatividade do mouse
let timer;

document.addEventListener("mousemove", () => {
    //Mostra o conteúdo

    if (!botaoResizeApertado) areaLink.style.display = "flex";
    document.body.style.cursor = "default";

    //Reinicia o timer
    clearTimeout(timer);

    timer = setTimeout(() => {
        //esconde o conteúdo depois de 2000ms
        if (player) {
            document.body.style.cursor = "none";
            areaLink.style.display = "none";
        }

    }, 2000);
})

window.addEventListener("resize", () => {
    areaDeVideo.style.width = "90vw";
    areaDeVideo.style.height = `${areaDeVideo.offsetWidth * 9 / 16}px`;
});

//EXECUÇÃO DAS FUNCÕES PRINCIPAIS
myVideos();
goVideo();